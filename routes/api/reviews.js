const express = require('express');
const router = express.Router();
const mongoose = require('mongoose')

const auth = require('../../middleware/auth');

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { check, validationResult } = require('express-validator');

const { getNextSequence, base64String } = require('../../utils/myUtils')

const Reviews = require('../../models/Reviews');
const Customer = require('../../models/Customer');
const User = require('../../models/User');
const Products = require('../../models/Product');


const apicache = require('apicache')
const cache = apicache.middleware

const onlyStatusSuccess = (req, res) => res.statusCode === 200 || req.statusCode === 206

const cacheSuccesses = cache('20 minutes', onlyStatusSuccess)

// @route    POST api/reviews
// @desc     Add review 
// @access   Public
router.post(
  '/',
  [
    // auth, 
    [
    check('rating', 'Please include a rating for product')
    .not()
    .isEmpty()
    ]
  ],
  async (req, res) => {

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
        
        const { comment, rating, id, user } = req.body

        let customerId
        const userId = user
        // console.log(userId)

        if (userId){
          const customer =  await Customer.findOne({"user_id": userId}, { __v: 0, _id: 0})
          if (customer){ customerId = customer.idx}
        }
        
        const product = await Products.findOne({ idx: id}, {__v:0, _id: 0})

        if(!product) return res.status(404).json("Product doesn't exist")

        const seq = await getNextSequence(mongoose.connection.db, 'reviewId')

        const newReview = new Reviews({
            idx: seq,
            comment: comment ? comment : '',
            rating: rating,
            product_id: product.idx,
            customer_id: customerId ? customerId : 9999999,//exclude this field when  customer_id = 9999999 
        })

        await newReview.save(); 
        return res.status(200).json({ 
          success: true, 
          message: 'Review Created Successfully' 
        })

    }catch(err) {
      // console.log(err)
      return res.status(500).json({ success: false, message: err.message})
    }
  }
);


// @route    GET api/reviews
// @desc     gett all reviews  
// @access   private
router.get(
    '/',
    cacheSuccesses,
    // auth,
    async (req, res) => {

      try {

        let reviews, header

        const filter = req.query.filter === undefined  || req.query.filter === '{}' ? {} : JSON.parse(req.query.filter)
        const range = req.query.range === undefined ? {} : JSON.parse(req.query.range)
        const sort = req.query.sort === undefined ? {} : JSON.parse(req.query.sort)

        // console.log("[REVIEWS - DECODEDURL]", decodeURIComponent(req.url.replace(/\+/g, ' ')))

        const count = await Reviews.countDocuments({}).exec()
        const chunksCollection = mongoose.connection.db.collection("previews.chunks") 
        const filesCollection = mongoose.connection.db.collection("previews.files")

        if (Object.keys(req.query).length === 0) {
          // reviews = await Reviews.find({ status: 'accepted'},{ __v: 0, _id: 0})     
          const limit = 5
          reviews = []
          for (var i = 0; i < limit; i++){
            
            var random = Math.floor(Math.random() * count)
            var review = await Reviews.findOne({status: 'accepted'}).skip(random)

            if (review){
              reviews.push(review)
            }
          }

          if (!reviews) return res.status(404).json("Reviews not Found")

          let product 
          let newReviews = []

          for (let rev of reviews){
            product = await Products.findOne({ idx: rev.product_id })

            if (!product) continue;
            
            const imageName = product.previews.length > 0 ? product.previews[0] :  "No Image";

            if (imageName !== "No Image"){  
                const blobs = await filesCollection.find({ "filename": imageName }).toArray()
                let ext, _imageBinaryJSON

                const blobsJSON = JSON.parse(JSON.stringify(blobs));
                ext = blobsJSON[0].filename.split('.')[1]

                const imageBinary = await chunksCollection.find({ "files_id" : mongoose.Types.ObjectId(blobsJSON[0]._id) }).toArray()
                _imageBinaryJSON = JSON.parse(JSON.stringify(imageBinary))

                rev = JSON.parse(JSON.stringify(rev))

                let chunksData = ''
                if (_imageBinaryJSON.length > 1){
                    _imageBinaryJSON.forEach(chun => {
                        chunksData += chun.data
                    });
                }else{
                    chunksData = _imageBinaryJSON[0].data
                }
                rev.base64 = base64String(chunksData, ext)

                rev.productName = product.name
                newReviews.push(rev)
            }
          }

          Reviews.setContentLimit(res, header, range, count)
          return res.status(206).json(newReviews)

        }else{
          if(range && sort){
            if (Object.keys(filter).length === 0){
                reviews = await Reviews.sort(sort, range)
                if (!reviews) return res.status(404).json("Reviews not found")
                // console.log("[REVIEWS - SORT]", reviews.length)
                Reviews.setContentLimit(res, header, range, count)
                return res.status(206).json(reviews)
            }

            if (Object.keys(filter).length > 0 && filter.q){
                reviews = await Reviews.textSearch(filter, sort, range)
                if (!reviews) return res.status(404).json("Reviews not Found")
                // console.log("[REVIEWS - QUERY]", reviews)
                Reviews.setContentLimit(res, header, range, count)
                return res.status(206).json(reviews)
            }

            if (Object.keys(filter).length > 0 && filter.customer_id){
                
                reviews = await Reviews.find({ customer_id: filter.customer_id }, {__v: 0, _id: 0})
                if (!reviews) return res.status(404).json("Reviews not Found")
                // console.log("[REVIEWS - QUERY(customer_id)]", reviews)
                Reviews.setContentLimit(res, header, range, count)
                return res.status(206).json(reviews)
            }

            if (Object.keys(filter).length > 0 && filter.product_id){
                reviews = await Reviews.find({ product_id: filter.product_id }, {__v: 0, _id: 0})

                if (!reviews || reviews.length == 0) return res.status(404).json("Reviews not Found")

                let filteredReviews = []

                for (let rev of reviews){
                  product = await Products.findOne({ idx: rev.product_id })
      
                  if (!product) continue;
                  
                  const imageName = product.previews.length > 0 ? product.previews[0] :  "No Image";
      
                  if (imageName !== "No Image"){  

                      const blobs = await filesCollection.find({ "filename": imageName }).toArray()
                      let ext, _imageBinaryJSON
      
                      const blobsJSON = JSON.parse(JSON.stringify(blobs));
                      ext = blobsJSON[0].filename.split('.')[1]

                      const imageBinary = await chunksCollection.find({ "files_id" : mongoose.Types.ObjectId(blobsJSON[0]._id) }).toArray()
                      _imageBinaryJSON = JSON.parse(JSON.stringify(imageBinary))
      
                      rev = JSON.parse(JSON.stringify(rev))

                      let chunksData = ''
                      if (_imageBinaryJSON.length > 1){
                          _imageBinaryJSON.forEach(chun => {
                              chunksData += chun.data
                          });
                      }else{
                          chunksData = _imageBinaryJSON[0].data
                      }
                      rev.base64 = base64String(chunksData, ext)
      
                      rev.productName = product.name
                      filteredReviews.push(rev)
                  }
                }
                // console.log("[REVIEWS - QUERY(product_id)]", reviews)
                Reviews.setContentLimit(res, header, range, filteredReviews.length)
                return res.status(206).json(filteredReviews)
            }
          }
        }
      }catch(err){
            // console.log(err)
        return res.status(500).json(err.message)
      }
    
});


// @route    GET api/reviews/:idx
// @desc     get review by id  
// @access   private
router.get(
  '/:idx',
  cacheSuccesses,
  // auth,
  async (req, res) => {

    try{

      const idx = parseInt(req.params.idx, 10)
      const review = await Reviews.findOne({"idx": idx},{_id: 0, __v: 0})
  
      if (review === null || review === undefined || review.length === 0){
  
          return res.status(400).json("No Review Exists")

      }

      return res.status(200).json(review)

    }catch(error){
      // console.log(error)
      return res.status(500).json(error.message)
    }
  }
);


// @route    PUT api/reviews/:idx
// @desc     Edit single Review
// @access   private
router.put('/', 
  // auth, 
  [

  ],
   async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try{

      console.log(req.body)
      const { comment, rating, status, id } = req.body

      const review = await Reviews.findOne({idx : id }, {_id:0, __v: 0})

      console.log(review)

      if (!review || review === null){
          return res.status(400).json("Review doesn't Exists")
      }

      review.comment = comment ? comment : review.comment
      review.rating = rating ? rating : review.rating
      review.status = status ? status : review.status

      await review.save();
      
      return res.status(200).json(review)

    }catch(err){
      // console.log(err)
      return res.status(500).json(err)
    }

})




// @route    DELETE api/reviews/:idx
// @desc     DELETE single Review by idx
// @access   private
router.delete('/:idx', auth, async (req, res, next) => {

  try{

    const idx = req.params.idx

    const exists = await Reviews.findOne({"idx": idx})
    if (!exists) {
      return res.status(404).json("Review doesn't exist")
    }

    const deletedReview =  await Reviews.findOneAndDelete({"idx": idx})

    return res.status(200).json({"Deleted": deletedReview})

  }catch(error) {
    // console.log(error)
    return res.status(500).json(error.message)
  }

})


//********** ADMIN ******/
// @route api/reviews - DELETE multiple reviews by (query.filter) 
// @desc Delete multiple reviews by Id 
// @access Private
router.delete('/', auth, async (req, res) => {
    
    try{

        const filter = req.query.filter ? JSON.parse(req.query.filter) : null

        const reviews = await Reviews.find({}, {_id: 0, __v:0}).where("idx").in(filter.id) 

        if (!reviews) {
             return res.status(404).json({ msg: 'reviews not found' });
        }

        await Reviews.deleteMany({idx: { $in : filter.id}});
        return res.status(200).json({"Message" : "Reviews Deleted Deleted"})

    }catch(err){
        // console.log(err);
        return res.status(500).send(err.message)
    }
})

module.exports = router;
